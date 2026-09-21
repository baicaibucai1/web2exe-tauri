@echo off
chcp 65001 >nul
title Web2Exe - Desktop
cd /d "%~dp0"

rem ---------------------------------------------------------------------------
rem Keep this .bat PURE ASCII.
rem
rem cmd.exe locates lines in a batch file by BYTE OFFSET. Multi-byte characters
rem make that offset drift and sooner or later a line gets split mid-character,
rem so "echo <chinese>" becomes "is not recognized as an internal or external
rem command". Measured: 8 KB of UTF-8 Chinese => only 19 of 69 lines ran, while
rem the same content in pure ASCII => 69/69 with an empty stderr.
rem
rem So every Chinese message is printed by Node (UTF-8 bytes, rendered correctly
rem thanks to the chcp 65001 above). See scripts/pack.mjs for the write-up.
rem ---------------------------------------------------------------------------

node scripts\launchers.mjs desktop
pause
