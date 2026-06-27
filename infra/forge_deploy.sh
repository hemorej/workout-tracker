$CREATE_RELEASE()

cd $FORGE_RELEASE_DIRECTORY

npm install
npm run db:migrate
npm run build

$ACTIVATE_RELEASE()