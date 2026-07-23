@echo off
chcp 65001 >nul
title FakeBot Client - Minecraft 假人客户端
cd /d "%~dp0"

echo ============================================
echo   FakeBot 一键启动 (Windows)
echo ============================================
echo.

REM 1) 优先用系统 PATH 里的 node
set "NODE_EXE=node"
set "NPM_CMD=npm"
where node >nul 2>nul
if %errorlevel% equ 0 goto :found

REM 2) 回退: WorkBuddy 内置 Node 运行时
set "WB_NODE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2"
if exist "%WB_NODE%\node.exe" (
    set "NODE_EXE=%WB_NODE%\node.exe"
    set "NPM_CMD=%WB_NODE%\npm.cmd"
    echo [提示] 使用内置 Node 运行时: %WB_NODE%
    goto :found
)

echo [错误] 未检测到 Node.js,请先安装: https://nodejs.org/
pause
exit /b 1

:found
REM 首次运行：自动安装依赖
if not exist "node_modules" (
    echo [首次运行] 正在安装依赖,请稍候...
    call "%NPM_CMD%" install --no-audit --no-fund
    if %errorlevel% neq 0 (
        echo [错误] 依赖安装失败,请检查网络
        pause
        exit /b 1
    )
    echo.
)

"%NODE_EXE%" src/index.js %*
pause
