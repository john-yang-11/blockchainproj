@echo off
rem Double-click to run everything locally: Solana validator + program (in WSL) and the website.
rem Close both windows (or Ctrl+C) to stop.
start "OnChain Place - local Solana chain" wsl -d Ubuntu-24.04 --cd "%~dp0" -- bash -lc "./scripts/local-chain.sh"
echo Waiting for the local chain to be deployed and seeded (first run builds the program, a few minutes)...
:wait
timeout /t 3 /nobreak >nul
powershell -NoProfile -Command "try { $r = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8899 -ContentType 'application/json' -Body '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getProgramAccounts\",\"params\":[\"6Pghm9oUF9Tx6VXUwGed7iKqL1qqnYvXciCUaCT63S3L\",{\"dataSlice\":{\"offset\":0,\"length\":0},\"filters\":[{\"dataSize\":10008}]}]}'; if ($r.result.Count -ge 25) { exit 0 } else { exit 1 } } catch { exit 1 }"
if errorlevel 1 goto wait
cd /d "%~dp0web"
if not exist node_modules call npm install
call npm run dev -- --open
