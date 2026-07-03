$CREATE_RELEASE()

cd $FORGE_RELEASE_DIRECTORY

$PNPM_PATH install --frozen-lockfile
$PNPM_PATH build
$PNPM_PATH db:migrate

$ACTIVATE_RELEASE()

sudo supervisorctl restart all