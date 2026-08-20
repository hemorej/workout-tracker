$CREATE_RELEASE()

cd $FORGE_RELEASE_DIRECTORY

$PNPM_PATH install --frozen-lockfile
$PNPM_PATH build
$PNPM_PATH db:migrate
$PNPM_PATH prune --prod

$ACTIVATE_RELEASE()

sudo supervisorctl restart daemon-912439:daemon-912439_00