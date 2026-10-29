const token = location.hash.slice(1);
history.replaceState(null, '', '/login');
try {
  const response = await fetch('/login', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  if (!response.ok) throw Error('This private link is invalid or already used. Restart the local dashboard for a new link.');
  location.replace('/');
} catch (error) { document.getElementById('status').textContent = error.message; }
