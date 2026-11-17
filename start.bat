@echo off
python "%~dp0tools\local.py" --server-artifact "%~dp0..\agentsys-server\agentsys-server-0.1.0.tgz" --client-artifact "%~dp0..\agentsys-client\agentsys-client-0.1.0.tgz" %*
