' ======================================================================
'  WD14 标签看板 (Electron) -- 静默启动
'  双击后不弹黑框, 直接起窗口。
'
'  【本文件必须保存为 ANSI(GBK) + CRLF】WSH 按 ANSI 读取 .vbs,
'  存成 UTF-8 会让下面的中文提示变成乱码。
'
'  需要看启动日志/排错时请改用「启动看板.bat」。
'
'  2026-10-20 冷启动体验修复(开机后点好几次图标才能启动):
'    1) flag 的删除权收归 electron 进程(main.js initLog 启动即清)。
'       旧逻辑每个 vbs 实例启动前都删一次 ready.flag, 连点两下时第二次
'       点击会毁掉第一次的就绪信号 —— 最坏情况: 第一个实例 BOOT OK 刚
'       写完 flag 就被第二个 vbs 删掉, 第一个 vbs 等满 30 秒弹"启动失败",
'       用户更确信坏了, 点第三次... 恶性循环。
'    2) flag 里的 pid 还活着 = 应用在跑, spawn 一下只为唤起已有窗口
'       (second-instance 事件), 拿到标记(新写的)就退。
'       pid 死了 = 上次的残留 flag, 安全删掉再正常启动。
'    3) 等待上限 30s -> 90s: 开机高峰(杀软全速扫盘)冷启动可能超过 30 秒,
'       误报"启动失败"只会诱导用户再点一次。
' ======================================================================
Option Explicit

Dim fso, sh, baseDir, exePath, indexPath, flagPath

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
exePath = baseDir & "\node_modules\electron\dist\electron.exe"
indexPath = baseDir & "\dist\index.html"
flagPath = baseDir & "\logs\ready.flag"

If Not fso.FileExists(exePath) Then
    MsgBox "找不到 Electron 运行时:" & vbCrLf & exePath & vbCrLf & vbCrLf & _
           "请先在项目目录执行一次:  npm install", 16, "TagViewer"
    WScript.Quit 1
End If

If Not fso.FileExists(indexPath) Then
    MsgBox "前端还没构建, 缺文件:" & vbCrLf & indexPath & vbCrLf & vbCrLf & _
           "请先执行:  npm run build", 16, "TagViewer"
    WScript.Quit 1
End If

' ---- flag 里的 pid 是否还活着(应用是否正在跑) ----
' WMI 不可用等异常一律返回 False(按"没有活实例"处理: 删残留 flag 照常启动)。
Function pidAlive
    Dim f, txt, re, m, pid, procs
    pidAlive = False
    On Error Resume Next
    If Not fso.FileExists(flagPath) Then Exit Function
    Set f = fso.OpenTextFile(flagPath, 1)
    If Err.Number <> 0 Then Err.Clear: Exit Function
    txt = f.ReadAll
    f.Close
    Set re = New RegExp
    re.Pattern = "pid=(\d+)"
    If re.Test(txt) Then
        Set m = re.Execute(txt)(0)
        pid = m.SubMatches(0)
        Set procs = GetObject("winmgmts:{impersonationLevel=impersonate}!\\.\root\cimv2") _
            .ExecQuery("SELECT ProcessId FROM Win32_Process WHERE ProcessId = " & pid)
        If procs.Count > 0 Then pidAlive = True
    End If
    If Err.Number <> 0 Then Err.Clear
End Function

If fso.FileExists(flagPath) Then
    If pidAlive Then
        ' 应用在跑: spawn 一次让主进程走 second-instance 唤起窗口, 等它刷新标记
        sh.Environment("Process").Remove "ELECTRON_RUN_AS_NODE"
        sh.CurrentDirectory = baseDir
        sh.Run """" & exePath & """ """ & baseDir & """", 1, False
        Dim k
        For k = 1 To 20                       ' 最多等 10 秒(热启动秒级就该刷好)
            WScript.Sleep 500
        Next
        WScript.Quit 0
    Else
        On Error Resume Next
        fso.DeleteFile flagPath, True         ' 残留标记: 没有活实例, 删了安全
        Err.Clear
        On Error Goto 0
    End If
End If

' 清除注入的 ELECTRON_RUN_AS_NODE: 必须用 Remove 真正删除变量
' 不能赋空串 -- 实测 Electron 把空值也当成纯 Node 模式, 会静默启动失败
sh.Environment("Process").Remove "ELECTRON_RUN_AS_NODE"

sh.CurrentDirectory = baseDir
' 0 = 隐藏窗口, False = 不等待返回
sh.Run """" & exePath & """ """ & baseDir & """", 1, False

' 静默启动没有任何反馈, 所以这里自己盯最多 90 秒(重启后冷启动实测要 18 秒,
' 开机高峰更久): 拿到就绪标记就悄悄退, 拿不到就把用户引到 bat 上去看日志
Dim i
For i = 1 To 180
    WScript.Sleep 500
    If fso.FileExists(flagPath) Then
        WScript.Quit 0
    End If
Next

MsgBox "看板启动失败。" & vbCrLf & vbCrLf & _
       "请双击「启动看板.bat」查看详细错误。" & vbCrLf & _
       "日志: " & baseDir & "\logs\launch.log", 16, "TagViewer"
WScript.Quit 1
