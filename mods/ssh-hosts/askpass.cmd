@echo off
rem SSH_ASKPASS on Windows: see askpass.py.
"%HERDR_SFTP_PYTHON%" -I "%~dp0askpass.py" %*
