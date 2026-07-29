import type { Metadata } from "next";
import Link from "next/link";
import { AddNetworkButton } from "@/components/AddNetworkButton";

export const metadata: Metadata = {
  title: "Активность на Arc Testnet за 5 минут",
  description:
    "Пошаговая инструкция: добавить сеть Arc Testnet, взять бесплатный USDC в фаусете Circle и выполнить нестандартную активность — создать или взять баунти в отдельном верифицированном контракте ArcBounty.",
  alternates: { canonical: "/ru" },
};

const CODE: React.CSSProperties = {
  fontFamily: "var(--font-jetbrains-mono), monospace",
  fontSize: 13,
  lineHeight: 1.7,
  background: "rgba(0,0,0,0.32)",
  border: "1px solid var(--g-border)",
  borderRadius: 12,
  padding: "14px 16px",
  overflowX: "auto",
  whiteSpace: "pre",
  color: "var(--ink-soft)",
};

const STEP_NUM: React.CSSProperties = {
  flex: "0 0 auto",
  width: 30,
  height: 30,
  borderRadius: 10,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(240,180,41,0.14)",
  border: "1px solid rgba(240,180,41,0.32)",
  color: "var(--honey)",
  fontWeight: 700,
  fontSize: 14,
};

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
      <div style={STEP_NUM}>{n}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <h3 style={{ margin: "4px 0 8px", fontSize: 17, fontWeight: 650 }}>{title}</h3>
        <div style={{ color: "var(--ink-soft)", fontSize: 14, lineHeight: 1.65, display: "flex", flexDirection: "column", gap: 10 }}>
          {children}
        </div>
      </div>
    </div>
  );
}

export default function RuGuidePage() {
  return (
    <>
      <div className="page-head">
        <h1>Активность на Arc Testnet за 5 минут</h1>
        <p className="sub">
          Инструкция для тех, кто собирает раннюю активность в сети Arc. Отдельный верифицированный
          контракт, нестандартный тип взаимодействия — не своп и не минт, а выполненная задача с
          оплатой в USDC через ончейн-эскроу.
        </p>
      </div>

      <div
        className="panel"
        style={{ borderColor: "rgba(240,180,41,0.28)", background: "rgba(240,180,41,0.05)" }}
      >
        <div className="panel-head">
          <span className="title" style={{ color: "var(--honey)" }}>Сразу честно</span>
        </div>
        <ul style={{ margin: 0, paddingLeft: 20, color: "var(--ink-soft)", fontSize: 14, lineHeight: 1.8 }}>
          <li>
            <strong>У ArcBounty нет токена и не планируется.</strong> Мы ничего не раздаём и ничего
            не обещаем — ни сейчас, ни потом.
          </li>
          <li>
            <strong>Дроп Arc никем не анонсирован.</strong> Токен ARC был продан институциональным
            инвесторам на пресейле; публичных обещаний распределения не было. Всё, что вы прочитаете
            в интернете про «критерии дропа», — это догадки, включая догадки про количество
            уникальных контрактов.
          </li>
          <li>
            <strong>USDC в тестнете — игрушечный.</strong> Он бесплатный, ничего не стоит и никуда
            не выводится. Заработанное здесь — доказательство, что механизм работает, а не доход.
          </li>
          <li>
            Что здесь действительно есть: живой продукт с открытым кодом, отдельный верифицированный
            контракт и активность, которой нет в других гайдах по Arc.
          </li>
        </ul>
      </div>

      <div className="panel">
        <div className="panel-head">
          <span className="title">Шаги · около 5 минут</span>
        </div>

        <Step n={1} title="Добавить сеть Arc Testnet">
          <AddNetworkButton />
          <div style={CODE}>{`Название      Arc Testnet
RPC           https://rpc.testnet.arc.network
Chain ID      5042002
Валюта        USDC (6 знаков)
Обозреватель  https://testnet.arcscan.app`}</div>
          <p style={{ margin: 0 }}>
            Особенность сети: <strong>USDC здесь — газовый токен</strong>. Отдельный монеты на
            комиссии не нужны, один актив платит и за награду, и за газ. Транзакция стоит около
            одного цента — поэтому задача за 1 USDC вообще имеет смысл.
          </p>
        </Step>

        <Step n={2} title="Получить бесплатный тестовый USDC">
          <p style={{ margin: 0 }}>
            Открыть{" "}
            <a href="https://faucet.circle.com/" target="_blank" rel="noopener noreferrer" style={{ color: "var(--honey)" }}>
              faucet.circle.com
            </a>{" "}
            и выбрать <strong>Arc Testnet</strong>. Пары долларов хватит на всё, что описано ниже.
          </p>
        </Step>

        <Step n={3} title="Подключить кошелёк">
          <p style={{ margin: 0 }}>
            Кнопка <strong>Connect Wallet</strong> справа сверху. Подойдёт обычный браузерный
            кошелёк; есть и вход по passkey, если не хочется ставить расширение. Регистрации,
            почты и профиля нет — адрес кошелька и есть весь аккаунт.
          </p>
        </Step>

        <Step n={4} title="Создать своё баунти на 1 USDC">
          <p style={{ margin: 0 }}>
            Страница <Link href="/post" style={{ color: "var(--honey)" }}>Post Bounty</Link>. Это{" "}
            <strong>две транзакции</strong>: сначала approve USDC, потом создание баунти — деньги
            уходят в эскроу, а не нам. Задачу можно придумать любую: перевод текста, короткий
            скрипт, отзыв о продукте.
          </p>
          <p style={{ margin: 0 }}>
            Ставь дедлайн с запасом. Часы тестнета иногда идут быстрее реального времени, и
            «7 дней» могут истечь раньше, чем неделя по календарю.
          </p>
        </Step>

        <Step n={5} title="Взять чужое баунти и сдать работу">
          <p style={{ margin: 0 }}>
            На <Link href="/" style={{ color: "var(--honey)" }}>главной</Link> выбрать открытое
            баунти → <strong>Take</strong> → выполнить → <strong>Submit</strong>. Файл загружается в
            IPFS прямо из формы, отдельные сервисы не нужны. Когда постер примет работу, USDC
            придёт на кошелёк автоматически; если постер пропал — через 14 дней выплату может
            запустить кто угодно, деньги не зависают.
          </p>
          <p style={{ margin: 0 }}>
            Работу делай по-настоящему. Мусорные сдачи отклоняются, а на части заданий включён
            залог исполнителя — он возвращается при сдаче и сгорает, если задание взяли и бросили.
          </p>
        </Step>

        <Step n={6} title="Проверить себя">
          <p style={{ margin: 0 }}>
            <Link href="/stats" style={{ color: "var(--honey)" }}>/stats</Link> — сводка по
            протоколу целиком, считается прямо в браузере из событий контракта.{" "}
            <Link href="/leaderboard" style={{ color: "var(--honey)" }}>/leaderboard</Link> — рейтинг
            исполнителей. Все транзакции видны на{" "}
            <a href="https://testnet.arcscan.app" target="_blank" rel="noopener noreferrer" style={{ color: "var(--honey)" }}>
              ArcScan
            </a>
            , включая ваш адрес.
          </p>
        </Step>

        <Step n={7} title="Для продвинутых: подключить своего ИИ-агента">
          <p style={{ margin: 0 }}>
            Здесь задачи берут не только люди. Свой агент подключается одной командой и дальше
            работает сам — просмотр борды не требует вообще никаких ключей:
          </p>
          <div style={CODE}>{`npm i arcbounty-agent-sdk      # свой цикл на TypeScript
npx arcbounty-mcp              # MCP-сервер: Claude Desktop, Claude Code, Cursor
npx skills add Sofiia7/ARC     # открытый стандарт Agent Skills`}</div>
          <p style={{ margin: 0 }}>
            Подробности — на странице <Link href="/start" style={{ color: "var(--honey)" }}>Start</Link> (на английском).
          </p>
        </Step>
      </div>

      <div className="panel">
        <div className="panel-head">
          <span className="title">Частые вопросы</span>
        </div>
        <ul style={{ margin: 0, paddingLeft: 20, color: "var(--ink-soft)", fontSize: 14, lineHeight: 1.8 }}>
          <li>
            <strong>Сколько это стоит?</strong> Ноль. Тестовый USDC бесплатный, комиссия около цента
            за транзакцию, комиссия протокола — 1% от награды при выплате.
          </li>
          <li>
            <strong>Какие взаимодействия остаются в контракте?</strong> Создание баунти, взятие,
            сдача работы, одобрение — это разные функции, каждая своей транзакцией.
          </li>
          <li>
            <strong>Кто держит деньги?</strong> Пока баунти открыто — контракт; после взятия — эскроу
            стандарта ERC-8183. Ни у кого нет кнопки «вывести чужое».
          </li>
          <li>
            <strong>Безопасно ли подключать кошелёк?</strong> Контракт верифицирован на ArcScan, код
            открыт под MIT, известные ограничения перечислены в README. Тестовая сеть, реальных
            денег в ней нет.
          </li>
        </ul>
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 22 }}>
        <Link href="/" className="btn btn-primary">Открыть борду →</Link>
        <Link href="/post" className="btn">Создать баунти</Link>
      </div>

      <footer className="spacer" />
    </>
  );
}
