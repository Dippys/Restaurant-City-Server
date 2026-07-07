@echo off
REM Launch the client so it loads FROM the local server. Because the game's
REM resource URLs are relative, loading game.swf from the server makes every
REM asset request resolve to the server too (and get logged in the dashboard).
set "PLAYER=C:\flex\Player\flashplayer_32_sa_debug.exe"
set "URL=http://localhost:8090/game.swf?cb=%RANDOM%%RANDOM%"
echo Launching client -^> %URL%
start "" "%PLAYER%" "%URL%"
