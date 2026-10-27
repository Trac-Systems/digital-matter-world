#!/usr/bin/env python3
"""Offline, per-service backup/restore. Never stops or starts a service."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile


def private_directory(path):
    path = Path(path)
    if not path.is_absolute() or path.resolve() != path or path.is_symlink():
        raise ValueError('canonical absolute directory required')
    st = path.stat()
    if not path.is_dir() or st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) != 0o700:
        raise ValueError('owned 0700 directory required')
    if any((p / '.git').exists() for p in [path, *path.parents]):
        raise ValueError('backup and service data must be outside repositories')
    return path


def inventory(source):
    if source.is_symlink() or not source.is_dir():
        raise ValueError('real source directory required')
    rows = []
    for path in sorted(source.rglob('*')):
        if path.is_symlink() or not (path.is_file() or path.is_dir()):
            raise ValueError('links and special files are forbidden')
        if path.is_file():
            rows.append({'path': str(path.relative_to(source)), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    return rows


def backup(source, destination):
    source, parent = private_directory(source), private_directory(Path(destination).parent)
    destination = Path(destination)
    if destination.exists() or destination == source or source in destination.parents:
        raise ValueError('new independent destination required')
    before = inventory(source)
    stage = Path(tempfile.mkdtemp(prefix='.backup-', dir=parent))
    try:
        shutil.copytree(source, stage / 'data', copy_function=shutil.copy2)
        if inventory(source) != before or inventory(stage / 'data') != before:
            raise ValueError('source changed during offline snapshot')
        manifest = stage / 'manifest.json'
        manifest.write_text(json.dumps({'version': 1, 'files': before}, indent=2))
        manifest.chmod(0o600)
        stage.rename(destination)
    finally:
        if stage.exists():
            shutil.rmtree(stage)


def restore(source, destination):
    source = private_directory(source)
    private_directory(Path(destination).parent)
    destination = Path(destination)
    if destination.exists():
        raise ValueError('restore requires a new destination; existing state is never overwritten')
    if (source / 'manifest.json').is_symlink():
        raise ValueError('manifest must be a regular file')
    manifest = json.loads((source / 'manifest.json').read_text())
    if manifest.get('version') != 1 or inventory(source / 'data') != manifest['files']:
        raise ValueError('backup checksum mismatch')
    shutil.copytree(source / 'data', destination)
    destination.chmod(0o700)
    if inventory(destination) != manifest['files']:
        raise ValueError('restore checksum mismatch')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['create', 'restore'])
    parser.add_argument('--unit', required=True, action='append')
    parser.add_argument('--source', required=True)
    parser.add_argument('--destination', required=True)
    args = parser.parse_args()
    for unit in args.unit:
        if not unit.startswith('dmw-') or '/' in unit:
            raise ValueError('explicit DMW service unit required')
        state = subprocess.check_output(['systemctl', 'show', '--property=ActiveState', '--value', unit], text=True).strip()
        if state not in ['inactive', 'failed']:
            raise ValueError('service must already be stopped for a consistent backup/restore')
    (backup if args.action == 'create' else restore)(args.source, args.destination)
    print('Verified private snapshot; service lifecycle unchanged.')


if __name__ == '__main__':
    main()
