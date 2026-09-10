var scope;
function install() {}
function uninstall() {}
async function startup({ rootURI }) {
  await Zotero.initializationPromise;
  scope = { Zotero, Services, IOUtils, PathUtils, URL, rootURI };
  Services.scriptloader.loadSubScript(rootURI + 'content/main.js', scope, 'UTF-8');
  await scope.PaperNext.startup();
}
function onMainWindowLoad({ window }) { scope?.PaperNext.register(window); }
function onMainWindowUnload({ window }) { scope?.PaperNext.unregister(window); }
async function shutdown() {
  await scope?.PaperNext.shutdown();
  scope = null;
}
