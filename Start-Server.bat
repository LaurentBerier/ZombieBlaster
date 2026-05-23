@echo off
setlocal
cd /d "%~dp0"

rem Prefer the py launcher: it picks the newest installed Python 3,
rem avoiding stale "python" shims (e.g. Anaconda 3.6) that fail on
rem modern syntax like `from __future__ import annotations`.
where py >nul 2>&1 && (
  py -3 serve.py
  goto :done
)
where python >nul 2>&1 && (
  python serve.py
  goto :done
)

echo.
echo  Python was not found in PATH. Install Python 3 or run from a terminal:
echo    cd /d "%~dp0"
echo    python serve.py
echo.
pause

:done
