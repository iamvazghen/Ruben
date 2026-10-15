@echo off
setlocal
rem RUBEN launcher. Lives on PATH so `ruben` works from any directory.
rem Settings (user environment variables, e.g. setx RUBEN_REPO D:\ruben):
rem   RUBEN_REPO      the checkout; default: two levels above this script, if it is one
rem   RUBEN_VPS       user@host running the gateway; needed only for pull/push/vps/logs
rem   RUBEN_VPS_HOME  state directory there (default ~/.ruben)
rem   RUBEN_VPS_UNIT  systemd user unit there (default ruben-gateway)
if not defined RUBEN_REPO if exist "%~dp0..\..\src\index.tsx" set "RUBEN_REPO=%~dp0..\.."
if not defined RUBEN_VPS_HOME set "RUBEN_VPS_HOME=~/.ruben"
if not defined RUBEN_VPS_UNIT set "RUBEN_VPS_UNIT=ruben-gateway"

if not exist "%RUBEN_REPO%\src\index.tsx" (
  echo [ruben] No RUBEN checkout found. Set RUBEN_REPO to it, e.g.:  setx RUBEN_REPO D:\ruben
  exit /b 1
)
set "NEEDS_VPS="
for %%c in (pull push vps logs) do if /i "%~1"=="%%c" set "NEEDS_VPS=1"
if defined NEEDS_VPS if not defined RUBEN_VPS (
  echo [ruben] "%~1" talks to your server. Set RUBEN_VPS first, e.g.:  setx RUBEN_VPS user@your-server
  exit /b 1
)

rem Pin the state directory to the checkout so memory, portfolio, scores and
rem cron jobs are the same set no matter which directory you launch from.
if not defined RUBEN_HOME set "RUBEN_HOME=%RUBEN_REPO%\.ruben"

pushd "%RUBEN_REPO%"

if /i "%~1"=="gateway" (
  rem Telegram + scheduled reviews. Normally the VPS owns this; running it here
  rem too would make two processes poll the same bot token and fight over updates.
  shift
  call bun run gateway %1 %2 %3 %4 %5 %6 %7 %8 %9
  goto :done
)
if /i "%~1"=="ask" (
  rem One-shot query for other processes: answer on stdout, no TTY needed.
  call node --import tsx src/ask.ts %2 %3 %4 %5 %6 %7 %8 %9
  goto :done
)
if /i "%~1"=="transcript" (
  call node --import tsx src/ask.ts %1 %2 %3 %4 %5 %6 %7 %8 %9
  goto :done
)
if /i "%~1"=="sessions" (
  call node --import tsx src/ask.ts %1 %2 %3
  goto :done
)
if /i "%~1"=="health" (
  call bun run health
  goto :done
)
if /i "%~1"=="test" (
  call bun test
  goto :done
)
if /i "%~1"=="pull" (
  rem The VPS is authoritative: Telegram conversations and the scheduled reviews
  rem all write there. This copies its memory and score ledger down so the local
  rem CLI sees the same history instead of a second, diverging brain.
  echo [ruben] pulling memory, scores and sessions from %RUBEN_VPS%
  scp -q "%RUBEN_VPS%:%RUBEN_VPS_HOME%/memory/MEMORY.md" "%RUBEN_HOME%\memory\MEMORY.md"
  rem No trailing backslash before the closing quote - cmd treats it as an escape
  rem and scp receives a mangled destination path.
  scp -qr "%RUBEN_VPS%:%RUBEN_VPS_HOME%/scores" "%RUBEN_HOME%"
  rem Telegram sessions live on the VPS; copy them so /resume telegram:... works here.
  if not exist "%RUBEN_HOME%\sessions" mkdir "%RUBEN_HOME%\sessions"
  scp -q "%RUBEN_VPS%:%RUBEN_VPS_HOME%/sessions/*_*.json" "%RUBEN_HOME%\sessions" 2>nul || echo [ruben] no sessions on the VPS yet
  rem Holdings, income plan, tax profile and targets: the VPS sends the reminders, so it holds the truth.
  scp -q "%RUBEN_VPS%:%RUBEN_VPS_HOME%/portfolio.json" "%RUBEN_HOME%" 2>nul
  scp -qr "%RUBEN_VPS%:%RUBEN_VPS_HOME%/income" "%RUBEN_HOME%" 2>nul
  scp -qr "%RUBEN_VPS%:%RUBEN_VPS_HOME%/rebalance" "%RUBEN_HOME%" 2>nul
  echo [ruben] done
  goto :done
)
if /i "%~1"=="push" (
  echo [ruben] pushing local memory and sessions to %RUBEN_VPS%
  scp -q "%RUBEN_HOME%\memory\MEMORY.md" "%RUBEN_VPS%:%RUBEN_VPS_HOME%/memory/MEMORY.md"
  rem CLI sessions, so Telegram can /resume cli:... - the copy pushed last wins.
  ssh %RUBEN_VPS% "mkdir -p %RUBEN_VPS_HOME%/sessions"
  for %%f in ("%RUBEN_HOME%\sessions\*_*.json") do scp -q "%%f" "%RUBEN_VPS%:%RUBEN_VPS_HOME%/sessions/"
  rem Holdings and income settings changed here must reach the VPS for reminders.
  if exist "%RUBEN_HOME%\portfolio.json" scp -q "%RUBEN_HOME%\portfolio.json" "%RUBEN_VPS%:%RUBEN_VPS_HOME%/"
  if exist "%RUBEN_HOME%\income" scp -qr "%RUBEN_HOME%\income" "%RUBEN_VPS%:%RUBEN_VPS_HOME%/"
  if exist "%RUBEN_HOME%\rebalance" scp -qr "%RUBEN_HOME%\rebalance" "%RUBEN_VPS%:%RUBEN_VPS_HOME%/"
  echo [ruben] done - restart the gateway there if it should pick it up now
  goto :done
)
if /i "%~1"=="vps" (
  rem Service control on the box that actually runs 24/7.
  ssh %RUBEN_VPS% "systemctl --user %2 %RUBEN_VPS_UNIT%; systemctl --user is-active %RUBEN_VPS_UNIT%"
  goto :done
)
if /i "%~1"=="logs" (
  ssh %RUBEN_VPS% "tail -n 40 %RUBEN_VPS_HOME%/gateway.log"
  goto :done
)

rem Node, not Bun: Bun on Windows never reports terminal resizes.
call node --import tsx src/index.tsx %*

:done
set "EXITCODE=%ERRORLEVEL%"
popd
exit /b %EXITCODE%
