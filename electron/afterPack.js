const { execSync } = require('child_process');
const path = require('path');

exports.default = async function (context) {
  const platform = context.electronPlatformName || context.packager?.platform?.name;
  if (platform !== 'darwin') {
    return;
  }

  const appOutDir = context.appOutDir;
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  console.log(`  • stripping provenance from all binaries in ${appPath}`);

  try {
    // macOS Sequoia adds com.apple.provenance at the kernel level
    // xattr -cr CANNOT remove it. The only fix is to recreate each file via cat
    // which creates a new file without the provenance flag

    // Find all Mach-O binaries and frameworks that codesign will touch
    const output = execSync(
      `find "${appPath}" -type f \\( -perm +111 -o -name "*.dylib" -o -name "*.so" \\)`,
      { encoding: 'utf-8' }
    ).trim();

    if (!output) {
      console.log('  • no executable files found, skipping');
      return;
    }

    const files = output.split('\n');
    let stripped = 0;

    for (const file of files) {
      if (!file) continue;
      try {
        // Check if file has provenance
        const attrs = execSync(`xattr -l "${file}" 2>/dev/null`, { encoding: 'utf-8' });
        if (attrs.includes('com.apple.provenance')) {
          // Recreate the file via cat to strip provenance
          const tmpFile = `${file}.clean`;
          execSync(`cat "${file}" > "${tmpFile}" && mv "${tmpFile}" "${file}"`, { stdio: 'pipe' });
          // Restore executable permission
          execSync(`chmod +x "${file}"`, { stdio: 'pipe' });
          stripped++;
        }
      } catch (e) {
        // Ignore files we can't process
      }
    }

    // Also handle non-executable files that might have provenance
    execSync(`find "${appPath}" -type f -exec sh -c 'xattr -l "$1" 2>/dev/null | grep -q provenance && tmp="$1.clean" && cat "$1" > "$tmp" && mv "$tmp" "$1"' _ {} \\;`, { stdio: 'pipe' });

    // Final xattr clear as belt-and-suspenders
    execSync(`xattr -cr "${appPath}" 2>/dev/null || true`, { stdio: 'pipe' });

    console.log(`  • stripped provenance from ${stripped} executables + all remaining files`);
  } catch (err) {
    console.warn('  • provenance strip error:', err.message);
  }

  // Ad-hoc sign so the unsigned build is LAUNCHABLE on Apple Silicon without an
  // Apple Developer account. A completely unsigned arm64 app gets quarantined as
  // "damaged and can't be opened" — and right-click→Open CANNOT fix that. An
  // ad-hoc signature ("-") downgrades it to the normal "unidentified developer"
  // prompt, which users bypass with a right-click→Open. Free, no cert needed.
  // MUST run last: the provenance strip above recreates files and invalidates
  // any prior signature. If the workflow later does real Developer-ID signing,
  // that simply re-signs over this — harmless.
  try {
    execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'pipe' });
    console.log('  • ad-hoc signed app bundle (launchable on Apple Silicon; right-click→Open)');
  } catch (e) {
    console.warn('  • ad-hoc sign failed:', e.message);
  }
};
