@echo off
REM Launch the repo-diagram MCP with this folder's own bun, so the server
REM needs nothing installed globally. Any arguments are passed through; the
REM first one, if present, is an initial repository root.
"%~dp0..\node_modules\.bin\bun.exe" run "%~dp0server.ts" %*
