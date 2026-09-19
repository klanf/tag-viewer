@echo off
rem ======================================================================
rem  WD14 标签看板 (Electron) -- 带诊断的启动脚本
rem  双击本文件即可启动看板。
rem
rem  【本文件必须保持 CRLF 换行 + ANSI(GBK) 编码, 不要改成 UTF-8】
rem  2026-09-18 踩过两次:
rem    1) 原文件是 UTF-8 无 BOM + LF 换行 -> cmd 按GBK解码中文注释,
rem       乱码字节里混出命令分隔符 -> 控制流错乱 -> 双击没反应。
rem    2) 改成 UTF-8(BOM) + chcp 65001 -> cmd 读多字节字符跨缓冲区错位,
rem       行首被吞(`rem ... 之前是` 变成 `前是`), 报一串"不是内部或外部命令"。
rem  本机 ACP=936, 所以正解就是 ANSI(GBK) + CRLF, 且不要 chcp。
rem  约束由 scripts/check-launchers.mjs 在 npm run build 时把守。
rem
rem  成功: 黑框停留约 1 秒自动关闭, 窗口出现。
rem  失败: 黑框保留并打印 logs\launch.log, 看清原因后按键退出。
rem
rem  日常使用建议双击「启动看板.vbs」(无控制台窗口)。
rem ======================================================================
setlocal EnableExtensions
set "DIR=%~dp0"
if "%DIR:~-1%"=="\" set "DIR=%DIR:~0,-1%"
set "EXE=%DIR%\node_modules\electron\dist\electron.exe"
set "INDEX=%DIR%\dist\index.html"
set "LOGDIR=%DIR%\logs"
set "LOG=%LOGDIR%\launch.log"
set "FLAG=%LOGDIR%\ready.flag"
set "TMPV=%TEMP%\tv_version.tmp"

rem 父进程/执行层可能注入 ELECTRON_RUN_AS_NODE, 留着 electron 会被当成纯 Node 跑
set "ELECTRON_RUN_AS_NODE="

pushd "%DIR%"

if not exist "%EXE%" goto :no_exe
if not exist "%INDEX%" goto :no_dist

rem ---- 预检 1: 运行时本身能不能起来(缺 DLL / 被安全软件拦 会在这里暴露) ----
"%EXE%" --version >"%TMPV%" 2>&1
if errorlevel 1 goto :bad_runtime
set "EVER="
set /p EVER=<"%TMPV%" 2>nul
del "%TMPV%" >nul 2>&1

rem ---- 预检 2: 清掉上次的就绪标记, 否则会把旧标记当成这一次的成功 ----
if not exist "%LOGDIR%" mkdir "%LOGDIR%" >nul 2>&1
del "%FLAG%" >nul 2>&1

rem ---- 正式启动 ----
if defined EVER (
    echo [TagViewer] 正在启动  Electron %EVER%
) else (
    echo [TagViewer] 正在启动看板 ...
)
start "" "%EXE%" "%DIR%"

rem ---- 等主进程写出就绪标记, 最多 30 秒(冷启动实测 18 秒) ----
for /L %%i in (1,1,30) do (
    if exist "%FLAG%" goto :launched
    call :tick
)
goto :failed

:launched
popd
exit /b 0

:tick
rem 拿 ping 当 sleep: timeout 在输入被重定向时会直接报错, ping 不会
ping -n 2 127.0.0.1 >nul
exit /b 0

:failed
echo.
echo [TagViewer] 启动失败: 主进程 30 秒内没写出就绪标记。
echo.
if exist "%LOG%" (
    echo ---------- logs\launch.log ----------
    type "%LOG%"
    echo ------------------------------------
) else (
    echo 连日志都没生成:  %LOG%
    echo 说明 Electron 进程根本没跑起来, 检查杀毒软件是否拦截了它。
)
echo.
pause
exit /b 1

:no_exe
echo [TagViewer] 找不到 Electron 运行时:
echo    %EXE%
echo.
echo 请先在项目目录执行一次:  npm install
echo.
pause
exit /b 1

:no_dist
echo [TagViewer] 前端还没构建, 缺文件:
echo    %INDEX%
echo.
echo 请先执行:  npm run build
echo.
pause
exit /b 1

:bad_runtime
echo [TagViewer] Electron 运行时无法启动:
echo    %EXE%
echo.
type "%TMPV%"
del "%TMPV%" >nul 2>&1
echo.
echo 常见原因: 运行时不完整(重跑 npm install) / 被安全软件拦截。
echo.
pause
exit /b 1
