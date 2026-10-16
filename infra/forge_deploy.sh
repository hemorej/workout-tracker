$CREATE_RELEASE()

cd $FORGE_RELEASE_DIRECTORY

# --ignore-scripts skips the root `postinstall` (`nuxt prepare`), which `nuxt build`
# runs itself. Dependency installs don't need lifecycle scripts (esbuild and
# @parcel/watcher ship prebuilt platform binaries).
$PNPM_PATH install --frozen-lockfile --ignore-scripts
$PNPM_PATH build
$PNPM_PATH db:migrate
# No `prune --prod`: `.output/` is a self-contained Nitro bundle (it carries its own
# traced node_modules), so the app never reads the release's node_modules at runtime.
# Migrate was the last step that needed the toolchain, so drop it (and the Nuxt build
# cache) to keep each retained release small.
rm -rf node_modules .nuxt

$ACTIVATE_RELEASE()

sudo supervisorctl restart daemon-912439:daemon-912439_00

# Free store files no longer linked by any release (old releases were just rotated
# out). The store is shared by every site on this server; pnpm only removes files
# nothing references. Last and non-fatal so it can never block the restart above.
$PNPM_PATH store prune || true
