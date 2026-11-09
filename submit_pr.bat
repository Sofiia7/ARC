@echo off
echo ===================================================
echo GabinoTech OS - Submit Bounty PR for Issue #36
echo Destination Payout: gabinotech22@gmail.com
echo ===================================================
git push origin fix/bounty-issue-4
gh pr create --title "Offer: a neutral, recomputable arbitrator for bounties with objective criteria" --body-file PR_CLAIM_BUNDLE.md
echo [OK] Pull Request submitted. Check https://github.com/Sofiia7/ARC/issues/4
pause
