' ======================================================================
'  WD14 标签看板 (Electron) -- 静默启动
'  双击后不弹黑框, 直接起窗口。
'
'  【本文件必须保存为 ANSI(GBK) + CRLF】WSH 按 ANSI 读取 .vbs,
'  存成 UTF-8 会让下面的中文提示变成乱码。
'
'  需要看启动日志/排错时请改用「启动看板.bat」。
' ======================================================================
Option Explicit

Dim fso, sh, env, baseDir, exePath, indexPath, flagPath, i

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

On Error Resume Next
If fso.FileExists(flagPath) Then fso.DeleteFile flagPath, True
' 清除注入的 ELECTRON_RUN_AS_NODE: 必须用 Remove 真正删除变量
' 不能赋空串 -- 实测 Electron 把空值也当成纯 Node 模式, 会静默启动失败
sh.Environment("Process").Remove "ELECTRON_RUN_AS_NODE"

sh.CurrentDirectory = baseDir
' 0 = 隐藏窗口, False = 不等待返回
sh.Run """" & exePath & """ """ & baseDir & """", 1, False

' 静默启动没有任何反馈, 所以这里自己盯 30 秒(重启后冷启动实测要 18 秒, 6 秒会误报失败):
' 拿到就绪标记就悄悄退, 拿不到就把用户引到 bat 上去看日志
For i = 1 To 60
    WScript.Sleep 500
    If fso.FileExists(flagPath) Then
        WScript.Quit 0
    End If
Next

MsgBox "看板启动失败。" & vbCrLf & vbCrLf & _
       "请双击「启动看板.bat」查看详细错误。" & vbCrLf & _
       "日志: " & baseDir & "\logs\launch.log", 16, "TagViewer"
WScript.Quit 1
