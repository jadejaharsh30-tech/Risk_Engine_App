@echo off
echo Starting Trading Risk Engine Local Server...
echo Please ensure Python is installed if this window closes immediately with an error.
echo Opening browser to http://localhost:8080/

:: Start the browser
start "" http://localhost:8080/

:: Launch the python server
python server.py

pause
