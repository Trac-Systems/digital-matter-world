// systemd LoadCredential= copies are read-only. Depending on the systemd
// version they are owned by the service user (directory 0700, file 0400) or by
// root (directory 0550, file 0440) with an ACL granting the service user read.
// Accept exactly those shapes: never writable, never readable by others.
export const credentialDirectoryOk = (st, uid = process.getuid()) =>
  st.isDirectory() && [0, uid].includes(st.uid) && (st.mode & 0o027) === 0;
export const credentialFileOk = (st, uid = process.getuid()) =>
  st.isFile() && [0, uid].includes(st.uid) && (st.mode & 0o227) === 0 && (st.mode & 0o400) !== 0 && st.size > 0 && st.size <= 4096;
