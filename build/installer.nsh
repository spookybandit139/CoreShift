!macro closeCoreShiftProcesses
  nsExec::ExecToStack '"$SYSDIR\taskkill.exe" /F /IM "CoreShift.exe"'
  Pop $0
  Pop $1
  Sleep 900
!macroend

!macro customInit
  !insertmacro closeCoreShiftProcesses
!macroend

!macro customUnInit
  !insertmacro closeCoreShiftProcesses
!macroend
