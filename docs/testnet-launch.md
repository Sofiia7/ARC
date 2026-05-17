# ArcBounty — Testnet Launch Runbook

Шаги от чистого клона до работающего MVP на Arc Testnet. Цель: первая публичная демонстрация для подачи на грант.

Время на всё: ~2–3 часа активной работы, ~1 день на «отлежаться» перед публичным анонсом.

---

## Предварительно: что нужно

| Зависимость | Где взять |
|---|---|
| `foundry` (forge + cast) | https://book.getfoundry.sh/getting-started/installation |
| `node >= 20` + `pnpm` или `npm` | https://nodejs.org |
| Кошелёк-деплоер (приватник, желательно отдельный) | MetaMask → Export → или новый |
| Arc Testnet ARC для газа | Faucet: https://faucet.testnet.arc.network (поискать в Arc Discord — ссылка может меняться) |
| Arc Testnet USDC (для смок-теста) | Тот же faucet, либо `cast send` на USDC с ролью minter (если faucet даёт) |
| Pinata API JWT (для IPFS) | https://app.pinata.cloud → API Keys |
| WalletConnect Project ID (опционально, для фронта) | https://cloud.walletconnect.com |
| Vercel аккаунт (для деплоя фронта) | https://vercel.com |

Перед стартом — обнови адреса AC/Identity/Reputation/USDC под актуальный Testnet (см. https://docs.arc.network/arc/references/contract-addresses). Текущие константы в репозитории — на апрель 2026.

---

## Шаг 1. Зелёная локальная сборка (15 минут)

```bash
git clone git@github.com:Sofiia7/ARC.git
cd ARC

# Контракты
cd contracts
forge install
forge build
forge test                        # 62 passed, 2 skipped
forge snapshot --check            # baseline сходится
cd ..

# Frontend
cd frontend
pnpm install
pnpm typecheck || npx tsc --noEmit
cd ..

# SDK
cd agent-sdk
npm install
npx tsc --noEmit
cd ..
```

Если что-то падает — стоп, чинить локально перед деплоем.

---

## Шаг 2. Заполнить .env (10 минут)

В корне создай `.env` (он в `.gitignore`):

```bash
# Деплоер (отдельный кошелёк, не основной)
PRIVATE_KEY=0x...
DEPLOYER_ADDRESS=0x...

# Arc Testnet
ARC_TESTNET_RPC_URL=https://rpc.testnet.arc.network

# Адреса канонические — сверить с docs.arc.network перед деплоем
AGENTIC_COMMERCE=0x0747EEf0706327138c69792bF28Cd525089e4583
IDENTITY_REGISTRY=0x8004A818BFB912233c491871b3d84c89A494BD9e
REPUTATION_REGISTRY=0x8004B663056A597Dffe9eCcC1965A193B7388713
USDC_ADDRESS=0x3600000000000000000000000000000000000000

# Куда пойдёт protocol fee 1%
FEE_RECIPIENT=0x...    # на старте — тот же что DEPLOYER_ADDRESS, перевести на multisig позже
```

Проверка газового баланса:

```bash
cast balance $DEPLOYER_ADDRESS --rpc-url $ARC_TESTNET_RPC_URL
# должно быть > 0; если нет — на faucet
```

---

## Шаг 3. Деплой BountyAdapter (5 минут + 1 транзакция)

```bash
cd contracts
source ../.env

forge script script/Deploy.s.sol \
  --rpc-url $ARC_TESTNET_RPC_URL \
  --private-key $PRIVATE_KEY \
  --broadcast \
  --verify
```

В выводе появится строка:

```
BountyAdapter deployed: 0xABCD...1234
```

Скопируй адрес. Дальше — `BOUNTY_ADAPTER_ADDRESS`.

Если `--verify` не сработал (Arcscan может не быть подключён) — без паники, верифицируем позже через UI.

Sanity-check, что байткод на месте:

```bash
cast code 0xABCD...1234 --rpc-url $ARC_TESTNET_RPC_URL | head -c 60
# должна быть длинная hex-строка, не 0x
```

---

## Шаг 3.5. ⚠️ ERC-8183 lifecycle на Arc Testnet требует Variant B потока

**Это реальный технический блокер, найденный при первом смоук-тесте новой версии контракта. Требует одного спринта рефакторинга (sprint 6).**

При деплое sprint-5 BountyAdapter и попытке `createBounty` транзакция падает на вызове `AC.setBudget(jobId, amount, "")`. Через `debug_traceTransaction` (Arcscan RPC поддерживает) видна цепочка успешных USDC.allowance/transferFrom/transfer/approve, успешный `AC.createJob`, затем revert на селекторе `0xdd4ae9d4` (= `setBudget(uint256,uint256,bytes)`).

**Корневая причина** (подтверждена прямыми вызовами AC от deployer-EOA):
1. AC.setBudget revert-ит с `ProviderNotSet()`, пока для job не вызван `setProvider`.
2. AC.setProvider — **one-shot**: повторный вызов с другим адресом silently fails.

Это значит наш Variant A (атомарный `createJob → setBudget → fund` внутри `createBounty` с `provider=0`) **принципиально несовместим** со стандартом — реальный ERC-8183 требует порядок `createJob → setProvider → setBudget → fund`, и provider нельзя поменять задним числом.

Также найдено: в реальном AC нет `refund(uint256,bytes)` и `expire(uint256,bytes)` — есть только `claimRefund(uint256)`. Наш интерфейс `IAgenticCommerce.sol` устарел в этих двух функциях.

**Что делать (sprint 6, отдельный PR)**:

1. **Перейти на Variant B lifecycle**:
   - `createBounty` пулит USDC от постера в адаптер + берёт fee + вызывает `AC.createJob`. **Без** `setBudget`/`fund`.
   - Адаптер временно держит `netReward` USDC.
   - `takeBounty(jobId, agentId)` вызывает `AC.setProvider(jobId, taker)` + `AC.setBudget(jobId, netReward, "")` + `AC.fund(jobId, "")` (последний пулит USDC из адаптера в AC-эскроу).
   - `cancelBounty` (до take) / `expireBounty` (deadline без take) возвращают USDC напрямую из адаптера постеру.
   - `rejectBounty` / `resolveDispute(payPoster)` после take вызывают `AC.claimRefund(jobId)` (новая сигнатура) и затем `_refundFromAC`.
2. **Обновить `IAgenticCommerce.sol`**: убрать `refund(uint256,bytes)` и `expire(uint256,bytes)`, добавить `claimRefund(uint256)` и `jobHasBudget(uint256)`.
3. **Обновить mock `MockAgenticCommerce` в тестах** под реальный flow setProvider→setBudget→fund.
4. **Обновить frontend ABI и тексты** (поле `funded` на BountyMeta становится осмысленным — true только после take, как было в первоначальном TZ §2.3).

Не критично для подачи на грант (вся остальная инфраструктура — MEV, dispute, sanctions, arbitrator, тесты, Slither, CI — независима от этого). Критично для end-to-end смоук-демо.

**Альтернатива на время** (для grant-демо): задеплоить наш `MockAgenticCommerce` рядом и переключить адаптер на mock через ENV (нужна минимальная правка в Deploy.s.sol). Тогда end-to-end флоу работает на Arc Testnet, но через mock AC, а не нативный — честно отметить это в демо.

**Что НЕ является причиной** (моя предыдущая гипотеза была неверной): compliance-precompile `0x1800…0001::isBlocklisted`. Реальные on-chain transfer USDC на новый адрес контракта проходят (балансы меняются). Симулятор `cast call --trace` показывает `StackUnderflow` на этом precompile — это артефакт инструмента, а не настоящий revert. Не отправляйте Arc team запрос на whitelisting.

---

## Шаг 4. Sanity-call контракта (5 минут)

```bash
cast call 0xABCD...1234 "agenticCommerce()(address)" --rpc-url $ARC_TESTNET_RPC_URL
# → AGENTIC_COMMERCE

cast call 0xABCD...1234 "feeBps()(uint256)" --rpc-url $ARC_TESTNET_RPC_URL
# → 100 (1%)

cast call 0xABCD...1234 "arbitrator()(address)" --rpc-url $ARC_TESTNET_RPC_URL
# → $DEPLOYER_ADDRESS (пока)

cast call 0xABCD...1234 "totalBounties()(uint256)" --rpc-url $ARC_TESTNET_RPC_URL
# → 0
```

Если все четыре отвечают — контракт жив.

---

## Шаг 5. Первый smoke-bounty с CLI (15 минут)

Это не требует фронта — проверяем, что цепочка `approve → createBounty → take → submit → approve` работает на реальной Arc.

```bash
ADAPTER=0xABCD...1234
USDC=0x3600000000000000000000000000000000000000
REWARD=2000000        # 2 USDC (6 decimals)
DEADLINE=$(($(date +%s) + 86400))   # сутки

# 1. Approve USDC adapter
cast send $USDC "approve(address,uint256)" $ADAPTER $REWARD \
  --rpc-url $ARC_TESTNET_RPC_URL --private-key $PRIVATE_KEY

# 2. createBounty (CreateParams tuple)
# Если нет под рукой второго кошелька-агента — пускай агент = тот же адрес (для smoke).
cast send $ADAPTER "createBounty((address,uint256,uint256,string,string,string[],bool,bool))" \
  "(0x0000000000000000000000000000000000000000,$REWARD,$DEADLINE,ipfs://QmSmokeDesc,other,[],false,false)" \
  --rpc-url $ARC_TESTNET_RPC_URL --private-key $PRIVATE_KEY

# 3. Узнать jobId — посмотри в receipt событие BountyCreated(jobId, ...)
#    или просто:
cast call $ADAPTER "totalBounties()(uint256)" --rpc-url $ARC_TESTNET_RPC_URL
# и возьми последний из allJobIds
```

Если хотя бы одна tx falls — лог в Arcscan покажет revert reason.

---

## Шаг 6. Передать arbitrator на multisig (10 минут)

**Делать до публичного анонса**, чтобы централизованный deployer-ключ не контролировал dispute-исходы.

```bash
# 1. Создать Gnosis Safe (или аналог) на Arc Testnet с 2/3 подписантами.
#    Можно через https://safe.global если он поддерживает Arc, иначе деплой
#    Safe-контрактов отдельно. Запиши MULTISIG_ADDRESS.

# 2. С deployer-кошелька:
cast send $ADAPTER "transferArbitrator(address)" $MULTISIG_ADDRESS \
  --rpc-url $ARC_TESTNET_RPC_URL --private-key $PRIVATE_KEY

# 3. С multisig (через Safe UI или cast с одним из подписантов):
cast send $ADAPTER "acceptArbitrator()" \
  --rpc-url $ARC_TESTNET_RPC_URL --private-key $MULTISIG_SIGNER_PK

# 4. Проверка:
cast call $ADAPTER "arbitrator()(address)" --rpc-url $ARC_TESTNET_RPC_URL
# → MULTISIG_ADDRESS
```

Если на Testnet нет смысла мудрить с Safe — оставь arbitrator = deployer и переключи на mainnet перед mainnet-деплоем (см. AUDIT.md runbook).

---

## Шаг 7. Sanctions oracle (опционально, 5 минут)

На Testnet оракула обычно нет. Можно:
- (a) Не включать: `sanctionsOracle = 0`, проверки выключены.
- (b) Развернуть mock и проверить, что вызывается:
```bash
forge create test/BountyAdapter.t.sol:MockSanctionsOracle \
  --rpc-url $ARC_TESTNET_RPC_URL --private-key $PRIVATE_KEY
# → ORACLE_ADDR

cast send $ADAPTER "setSanctionsOracle(address)" $ORACLE_ADDR \
  --rpc-url $ARC_TESTNET_RPC_URL --private-key $MULTISIG_SIGNER_PK
```

На mainnet — поставить адрес Chainalysis Sanctions Oracle (см. https://go.chainalysis.com/chainalysis-oracle-docs.html).

---

## Шаг 8. Frontend на Vercel (20 минут)

```bash
cd frontend
cp .env.example .env.local
# Заполнить:
# NEXT_PUBLIC_RPC_URL=https://rpc.testnet.arc.network
# NEXT_PUBLIC_BOUNTY_ADAPTER_ADDRESS=0xABCD...1234
# NEXT_PUBLIC_WC_PROJECT_ID=...
# PINATA_JWT=eyJhbGc...

pnpm dev
# → открыть localhost:3000, проверить что главная грузится, /post работает
```

Deploy:

```bash
npx vercel --prod
# или: установить gh-cli + Vercel integration, привязать к репо
```

В Vercel Dashboard → Project Settings → Environment Variables → продублировать `.env.local` (без `NEXT_PUBLIC_` будут только серверные).

После деплоя:
1. Открой публичный URL, подключи кошелёк.
2. Создай demo-баунти через UI на 2 USDC.
3. С второго кошелька возьми, сабмитни ipfs://Qm... любой valid CID.
4. С первого — `Approve & Pay` со score 95.
5. Проверь в Arcscan, что USDC ушёл воркеру, fee ушёл feeRecipient.

---

## Шаг 9. SDK и demo-агент (30 минут)

Опубликуем SDK на npm (можно под scope, например `@arcbounty/agent-sdk`):

```bash
cd agent-sdk

# package.json: проверь name (можно поставить @yourorg/arcbounty-agent-sdk если без scope занято)
npm run build
npm login
npm publish --access public
```

Запусти demo-агента:

```bash
# В examples/demo-agent.ts уже есть рабочий пример. Перед запуском:
export AGENT_PRIVATE_KEY=0x...    # ВТОРОЙ кошелёк, не deployer
export BOUNTY_ADAPTER_ADDRESS=0xABCD...1234
export ARC_TESTNET_RPC_URL=https://rpc.testnet.arc.network
export PINATA_JWT=eyJhbGc...

npx tsx examples/demo-agent.ts
```

Что должно произойти:
1. Агент регистрируется в ERC-8004 (или находит existing agentId).
2. Сканирует open баунти.
3. Берёт первую подходящую (если есть).
4. Имитирует выполнение и сабмитит.
5. Логи: `agentId=X, taken=#Y, submitted=ipfs://...`

---

## Шаг 10. Expiry-runner (15 минут)

Permissionless, можно запустить из любого места. Простейший способ — GitHub Action `schedule`:

`.github/workflows/expiry-runner.yml` (создать):

```yaml
name: expiry-runner
on:
  schedule:
    - cron: "*/15 * * * *"   # каждые 15 минут
  workflow_dispatch: {}

jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: cd agent-sdk && npm install
      - env:
          EXPIRY_RUNNER_PRIVATE_KEY: ${{ secrets.EXPIRY_RUNNER_PRIVATE_KEY }}
          BOUNTY_ADAPTER_ADDRESS: ${{ vars.BOUNTY_ADAPTER_ADDRESS }}
          ARC_TESTNET_RPC_URL: ${{ vars.ARC_TESTNET_RPC_URL }}
        run: cd agent-sdk && npx tsx examples/expiry-runner.ts
```

Положить secret `EXPIRY_RUNNER_PRIVATE_KEY` в репо (Settings → Secrets → Actions). Этот кошелёк должен иметь немного ARC на газ ($1–2).

---

## Шаг 11. Smoke-чеклист публичности

Перед тем как кидать ссылку в Arc Discord:

- [ ] `cast call $ADAPTER "arbitrator()(address)"` возвращает multisig (или временно deployer с явным комментарием)
- [ ] `feeRecipient` — multisig
- [ ] На главной (Vercel URL) видно ≥ 3 живых баунти
- [ ] Хотя бы одна баунти выполнена end-to-end (видна как `Finalized` со ссылкой на результат в IPFS)
- [ ] `forge test`, Slither, snapshot — все зелёные на main
- [ ] Arcscan показывает контракт с правильным constructor params
- [ ] SECURITY.md видно в README с прямой ссылкой
- [ ] Issue tracker открыт, есть `bug-report.yml` шаблон с явной просьбой не репортить уязвимости публично

---

## Шаг 12. Что мониторить первые 7 дней

| Метрика | Где смотреть | Действие при отклонении |
|---|---|---|
| Стучатся ли в `createBounty` | Arcscan → events → `BountyCreated` | < 5 за день — спросить в Arc Discord обратную связь |
| Стак-трейсы на фронте | Vercel Logs / Sentry | фиксить ASAP |
| Газовая регрессия на `forge snapshot` | PR-чек | не мерджить если красное |
| Баланс expiry-runner кошелька | Arcscan | пополнять, когда < $1 |
| Open dispute-кейсы | `DisputeRaised` event | руками резолвить через multisig (резолв занимает ~30 сек) |

---

## Если что-то пошло не так

| Симптом | Что делать |
|---|---|
| `revert: insufficient USDC allowance` | На фронте — недокликнули approve. На CLI — забыли `cast send $USDC approve...` |
| `revert: bounty expired` при takeBounty | Дедлайн уже прошёл, запостить новую с большим запасом |
| `revert: sanctioned address` | Oracle включён и адрес помечен. Снять помечу или отключить oracle (`setSanctionsOracle(0)` с multisig) |
| Vercel build падает на `tsc` | Локально `pnpm typecheck`, фиксить, новый деплой триггерится с git push |
| Expiry-runner молчит | Проверь `EXPIRY_RUNNER_PRIVATE_KEY` секрет в репо + баланс ARC у этого кошелька |
| Slither упал в CI на нового PR | Запусти локально `/tmp/slither-venv/bin/slither src/BountyAdapter.sol --config-file slither.config.json --fail-medium --exclude reentrancy-benign,timestamp` |

---

## После всего этого

Можно (и нужно) скрин из Arcscan + публичный URL → приложить к гранту вместе с `pitch_deck.md` и `docs/grant-letter.md`. Это превращает заявку из «обещаю» в «уже работает, вот транзакции».
