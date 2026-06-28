$CREATE_RELEASE()

cd $FORGE_RELEASE_DIRECTORY

npm install
npm run build
npm run db:migrate

$ACTIVATE_RELEASE()

sudo supervisorctl restart all