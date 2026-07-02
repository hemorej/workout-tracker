$CREATE_RELEASE()

cd $FORGE_RELEASE_DIRECTORY

/home/forge/.local/share/pnpm/bin/pnpm install --frozen-lockfile
/home/forge/.local/share/pnpm/bin/pnpm build
/home/forge/.local/share/pnpm/bin/pnpm db:migrate

$ACTIVATE_RELEASE()

sudo supervisorctl restart all
