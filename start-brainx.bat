@echo off
setlocal EnableDelayedExpansion
set "HERE=%~dp0"
cd /d "%HERE%" || (echo Cannot change directory to %HERE% & pause & goto :eof)

if not exist "start-brainx.sh" (
  echo Missing start-brainx.sh next to this launcher.
  pause
  goto :eof
)

set "BASH_EXE="

rem 1) bash / git-bash on PATH
for %%C in (bash.exe git-bash.exe) do (
  for /f "delims=" %%P in ('where %%C 2^>nul') do (
    if not defined BASH_EXE if exist "%%P" set "BASH_EXE=%%P"
  )
)

rem 2) derive bash from the git install location
if not defined BASH_EXE (
  for /f "delims=" %%G in ('where git.exe 2^>nul') do (
    if not defined BASH_EXE (
      set "GD=%%~dpG"
      for %%B in ("!GD!bash.exe" "!GD!..\bin\bash.exe" "!GD!..\usr\bin\bash.exe" "!GD!..\..\bin\bash.exe" "!GD!..\..\usr\bin\bash.exe") do (
        if exist %%B set "BASH_EXE=%%~B"
      )
    )
  )
)

rem 3) common install locations
if not defined BASH_EXE (
  for %%B in (
    "C:\Program Files\Git\bin\bash.exe"
    "C:\Program Files\Git\usr\bin\bash.exe"
    "C:\Program Files (x86)\Git\bin\bash.exe"
    "C:\Program Files (x86)\Git\usr\bin\bash.exe"
    "%LOCALAPPDATA%\Programs\Git\bin\bash.exe"
    "%LOCALAPPDATA%\Programs\Git\usr\bin\bash.exe"
    "%USERPROFILE%\scoop\apps\git\current\bin\bash.exe"
    "C:\tools\Git\bin\bash.exe"
    "C:\git\bin\bash.exe"
    "C:\msys64\usr\bin\bash.exe"
  ) do (
    if not defined BASH_EXE if exist %%B set "BASH_EXE=%%~B"
  )
)

if defined BASH_EXE (
  set "GIT_BASH_EXE=%BASH_EXE%"
  "%BASH_EXE%" start-brainx.sh
  if errorlevel 1 pause
  goto :eof
)

echo Git Bash was not found on this machine.
echo Options:
echo   1^) Install Git for Windows: https://git-scm.com/download/win
echo   2^) Open Git Bash, cd to this folder, then run:  bash start-brainx.sh
pause
:eof
endlocal
