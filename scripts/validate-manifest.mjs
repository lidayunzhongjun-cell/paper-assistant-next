// Zotero imposes additional requirements beyond the generic WebExtension schema.
// Keep these checks in the build so a ZIP/startup smoke test cannot mask them.
export function validateManifest(manifest, expectedVersion) {
  if (manifest.manifest_version !== 2) throw new Error('manifest_version must be 2');
  for (const field of ['name', 'version']) {
    if (typeof manifest[field] !== 'string' || !manifest[field].trim()) {
      throw new Error(`${field} not provided`);
    }
  }
  if (expectedVersion && manifest.version !== expectedVersion) throw new Error('版本不一致');
  const app = manifest.applications?.zotero;
  for (const field of ['id', 'update_url', 'strict_min_version', 'strict_max_version']) {
    if (typeof app?.[field] !== 'string' || !app[field].trim()) {
      throw new Error(`applications.zotero.${field} not provided`);
    }
  }
  const update = new URL(app.update_url);
  if (update.protocol !== 'https:' || update.username || update.password) {
    throw new Error('applications.zotero.update_url must be a credential-free HTTPS URL');
  }
  if (app.strict_min_version.includes('*')) {
    throw new Error('applications.zotero.strict_min_version cannot contain *');
  }
  if (app.id === 'paper-assistant@astralscarsmoonshadow') {
    throw new Error('Next must not overwrite the original plugin ID');
  }
}
