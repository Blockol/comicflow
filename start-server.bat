@echo off
title ComicFlow Local Server
echo.
echo  ComicFlow Local Server wird gestartet...
echo  Comics werden lokal in data\comics\ gespeichert.
echo.
node server.js
if %errorlevel% neq 0 (
    echo.
    echo  FEHLER: Node.js nicht gefunden!
    echo  Bitte Node.js installieren: https://nodejs.org
    echo.
)
pause
