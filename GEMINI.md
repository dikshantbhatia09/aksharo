# User Instructions and Operational Directives

## CRITICAL DEPLOYMENT DIRECTIVE
Whenever the user commands to make changes to the codebase or fix issues:
1. **Directly implement the changes and verify them completely** with automated tests across the codebase.
2. **Push the changes to LIVE immediately**:
   - The production environment for Aksharo runs on this host machine (ports `3913` for API, `3914` for Web, plus `worker-media`, `worker-ai`, `render`) exposed to the public internet via Cloudflare Tunnel at `aksharo.crestmondtechnologies.com` and `aksharo-api.crestmondtechnologies.com`.
   - Update `montaj-release` (`c:\Dikshant\Crest Mond\Product 2\05-build\montaj-release`) with the verified changes.
   - Rebuild modified packages and artifacts in `montaj-release`.
   - Restart the production stack using `_orchestration\tools\stop-production-stack.ps1` and `_orchestration\tools\start-production-stack.ps1`.
   - Commit and push changes to GitHub `origin/main` (`https://github.com/dikshantbhatia09/aksharo.git`).
   - Confirm that the changes are actively visible and running on live (`https://aksharo.crestmondtechnologies.com`).

