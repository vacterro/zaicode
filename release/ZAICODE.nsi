Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
Var NoIntegration
Name "ZAICODE"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\ZAICODE"
InstallDirRegKey HKCU "Software\ZAICODE" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
ShowInstDetails show
ShowUninstDetails show
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "ZAICODE"
VIAddVersionKey "FileDescription" "ZAICODE complete Windows setup"
VIAddVersionKey "FileVersion" "${VERSION}"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\ZAICODE.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Launch ZAICODE"
!define MUI_FINISHPAGE_SHOWREADME
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Create a desktop shortcut"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION DesktopShortcut
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "Russian"
!insertmacro MUI_LANGUAGE "Estonian"

Function .onInit
    StrCpy $NoIntegration 0
    ${GetParameters} $0
    ClearErrors
    ${GetOptions} $0 "/NOINTEGRATION" $1
    ${IfNot} ${Errors}
        StrCpy $NoIntegration 1
    ${EndIf}
FunctionEnd

Section "ZAICODE and managed runtimes" SEC_MAIN
    SetShellVarContext current
    IfFileExists "$INSTDIR\install\install-state.json" 0 new_install
    ExecWait '"$INSTDIR\tools\ZAICODE-runtime.exe" /check-install' $0
    FileOpen $9 "$INSTDIR\install\installer-stage.log" w
    FileWrite $9 "check-install=$0$\r$\n"
    FileClose $9
    ${If} $0 != 0
        IfSilent +2
        MessageBox MB_OK|MB_ICONINFORMATION "Close ZAICODE before repairing or upgrading this installation. Your data will be kept."
        SetErrorLevel 1
        Abort
    ${EndIf}
    new_install:
    SetOutPath "$INSTDIR"
    File /r "${PAYLOAD}\*"
    DetailPrint "Verifying and preparing the installed release..."
    ; Capture the managed bootstrap error in the install directory so a
    ; silent installer still leaves an actionable diagnostic.
    nsExec::ExecToStack /TIMEOUT=600000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\install\Update-ZAICODE.ps1" -Initialize -InstallDir "$INSTDIR"'
    Pop $0
    Pop $1
    FileOpen $9 "$INSTDIR\install\installer-stage.log" a
    FileWrite $9 "initialize=$0$\r$\noutput=$1$\r$\n"
    FileClose $9
    ${If} $0 != 0
        IfSilent +2
        MessageBox MB_OK|MB_ICONSTOP "ZAICODE installation verification failed. Your existing application and user data are preserved. See the installation details."
        SetErrorLevel 1
        Abort
    ${EndIf}
    WriteUninstaller "$INSTDIR\Uninstall.exe"
    IfFileExists "$INSTDIR\install\no-integration" 0 +2
    StrCpy $NoIntegration 1
    ${If} $NoIntegration == 1
        FileOpen $0 "$INSTDIR\install\no-integration" w
        FileWrite $0 "Isolated acceptance installation"
        FileClose $0
        Goto integration_done
    ${EndIf}
    CreateDirectory "$SMPROGRAMS\ZAICODE"
    CreateShortcut "$SMPROGRAMS\ZAICODE\ZAICODE.lnk" "$INSTDIR\ZAICODE.exe"
    CreateShortcut "$SMPROGRAMS\ZAICODE\Uninstall ZAICODE.lnk" "$INSTDIR\Uninstall.exe"
    WriteRegStr HKCU "Software\ZAICODE" "InstallDir" "$INSTDIR"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ZAICODE" "DisplayName" "ZAICODE"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ZAICODE" "DisplayVersion" "${VERSION}"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ZAICODE" "DisplayIcon" "$INSTDIR\ZAICODE.exe"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ZAICODE" "UninstallString" '"$INSTDIR\Uninstall.exe"'
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ZAICODE" "InstallLocation" "$INSTDIR"
    WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ZAICODE" "NoModify" 1
    WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ZAICODE" "NoRepair" 0
    integration_done:
SectionEnd

Function DesktopShortcut
    ${If} $NoIntegration == 1
        Return
    ${EndIf}
    SetShellVarContext current
    CreateShortcut "$DESKTOP\ZAICODE.lnk" "$INSTDIR\ZAICODE.exe"
FunctionEnd

Section "Uninstall"
    SetShellVarContext current
    IfSilent uninstall_confirmed
    MessageBox MB_OKCANCEL|MB_ICONINFORMATION "ZAICODE will be removed. Your settings, sessions, mailboxes and projects will be kept." IDCANCEL cancel
    uninstall_confirmed:
    nsExec::ExecToStack '"$INSTDIR\tools\ZAICODE-runtime.exe" /check-install'
    Pop $0
    Pop $1
    ${If} $0 != 0
        IfSilent +2
        MessageBox MB_OK|MB_ICONINFORMATION "Close ZAICODE before uninstalling. Your data will be kept."
        SetErrorLevel 1
        Abort
    ${EndIf}
    IfFileExists "$INSTDIR\install\no-integration" skip_integration
    Delete "$DESKTOP\ZAICODE.lnk"
    Delete "$SMPROGRAMS\ZAICODE\ZAICODE.lnk"
    Delete "$SMPROGRAMS\ZAICODE\Uninstall ZAICODE.lnk"
    RMDir "$SMPROGRAMS\ZAICODE"
    DeleteRegKey HKCU "Software\ZAICODE"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ZAICODE"
    skip_integration:
    RMDir /r "$INSTDIR\versions"
    RMDir /r "$INSTDIR\managed"
    RMDir /r "$INSTDIR\tools"
    RMDir /r "$INSTDIR\install"
    RMDir /r "$INSTDIR\staging"
    RMDir /r "$INSTDIR\stage"
    Delete "$INSTDIR\ZAICODE.exe"
    Delete "$INSTDIR\Uninstall.exe"
    RMDir "$INSTDIR"
    cancel:
SectionEnd
