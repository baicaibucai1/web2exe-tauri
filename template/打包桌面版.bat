@echo off
chcp 65001 >nul
title Build Installer
cd /d "%~dp0"

rem ---------------------------------------------------------------------------
rem IMPORTANT: keep this .bat PURE ASCII.
rem
rem cmd.exe locates lines in a batch file by BYTE OFFSET. Multi-byte characters
rem make that offset drift, and sooner or later a line gets split in the middle
rem of a character -- so "echo <chinese>" turns into
rem "'...' is not recognized as an internal or external command".
rem
rem Measured with the same content, run via  CMD /D /C <file>:
rem   pure ASCII + CRLF, 5733 bytes        -> 69/69 lines OK, stderr empty
rem   UTF-8 no BOM + CRLF, 8318 bytes      -> only 19/69 lines, lots of garbage
rem   GBK + CRLF, 5845 bytes               -> OK, but clashes with Node's UTF-8
rem   UTF-8 with BOM                       -> BOM is treated as part of the command
rem   ASCII wrapper that does chcp 65001 then calls the UTF-8 file -> still 19/69
rem
rem So: every Chinese message is printed by Node instead (Node writes UTF-8 bytes,
rem and the chcp 65001 above makes them render correctly).
rem Full investigation is in the header comment of scripts/pack.mjs.
rem ---------------------------------------------------------------------------

node scripts\pack.mjs
pause
