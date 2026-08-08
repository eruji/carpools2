# deploy.ps1 — push to GitHub, Unraid auto-updates via Watchtower
# Usage: .\deploy.ps1

Write-Host "📦 Pushing to GitHub..." -ForegroundColor Green
git add .
git commit -m "update" --allow-empty
git push

Write-Host "✅ Pushed! Unraid will auto-update within 5 minutes." -ForegroundColor Green
