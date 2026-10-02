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

// Zotero's strict_min/max_version are inclusive. This covers the numeric
// release ranges used by this project (for example 9.0 through 10.0.*).
export function supportsZoteroVersion(manifest, version) {
  const parts = value => {
    const match = /^(\d+(?:\.\d+)*)(\.\*)?$/.exec(value);
    if (!match) throw new Error(`Unsupported Zotero version range: ${value}`);
    return { numbers: match[1].split('.').map(Number), wildcard: Boolean(match[2]) };
  };
  const compare = (left, right) => {
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      const difference = (left[i] || 0) - (right[i] || 0);
      if (difference) return Math.sign(difference);
    }
    return 0;
  };
  const actual = parts(version).numbers;
  const minimum = parts(manifest.applications.zotero.strict_min_version);
  const maximum = parts(manifest.applications.zotero.strict_max_version);
  if (minimum.wildcard) throw new Error('strict_min_version cannot contain *');
  return compare(actual, minimum.numbers) >= 0 &&
    compare(maximum.wildcard ? actual.slice(0, maximum.numbers.length) : actual, maximum.numbers) <= 0;
}
