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

$ACTIVATE_RELEASE()

sudo supervisorctl restart daemon-912439:daemon-912439_00