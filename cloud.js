/* MedBuddy — accounts and cloud sync, built on Supabase.
   The anon key below is intentionally public: it identifies the project,
   not a user. All protection comes from Row Level Security on the server —
   a signed-in client can only ever read or write its own user's row,
   no matter what it sends. */

const SUPABASE_URL = 'https://qyiwjooxxgkneypeurwy.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF5aXdqb294eGdrbmV5cGV1cnd5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ5OTkyNzIsImV4cCI6MjEwMDU3NTI3Mn0.qMxmJIIVxAdXwRj04Y_E_xsq4-mfw4vgWzvQek-POvM';

(function () {
  let sb = null;
  let signedIn = false;
  let currentUser = null;
  let pushTimer = null;
  let onAuthed = null;
  let mode = 'signin';
  let wired = false;

  /* The CDN script can be missing when the app starts offline — every
     entry point checks this and falls back to local-only mode. */
  function available() {
    return typeof window.supabase !== 'undefined';
  }

  function client() {
    if (!sb) {
      sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {
          persistSession: true, // keep the session in localStorage across reloads
          autoRefreshToken: true, // renew expired tokens silently
          detectSessionInUrl: true,
        },
      });
    }
    return sb;
  }

  async function getSession() {
    if (!available()) return null;
    const { data } = await client().auth.getSession();
    currentUser = data.session ? data.session.user : null;
    signedIn = !!currentUser;
    return data.session;
  }

  function isSignedIn() {
    return signedIn;
  }

  function userId() {
    return currentUser ? currentUser.id : null;
  }

  function userEmail() {
    return currentUser ? currentUser.email : '';
  }

  /* ------------------------------------------------------------------- */
  /* State sync — one row per user, whole state as JSON                   */
  /* ------------------------------------------------------------------- */

  async function fetchState() {
    const { data, error } = await client().from('app_state').select('data').maybeSingle();
    if (error) throw error;
    return data ? data.data : null;
  }

  async function pushState(stateObj) {
    if (!signedIn || !currentUser) return;
    const { error } = await client().from('app_state').upsert({
      user_id: currentUser.id,
      data: stateObj,
      updated_at: new Date().toISOString(),
    });
    if (error) console.warn('Cloud sync failed:', error.message);
  }

  function pushStateDebounced(stateObj) {
    clearTimeout(pushTimer);
    const snapshot = JSON.parse(JSON.stringify(stateObj));
    pushTimer = setTimeout(() => {
      pushState(snapshot).catch((err) => console.warn('Cloud sync failed:', err));
    }, 1200);
  }

  /* ------------------------------------------------------------------- */
  /* Leaderboard — opt-in only. Only a chosen nickname and a streak       */
  /* number are ever written here, never anything from `state` itself —  */
  /* the medication data stays exactly as private as before.             */
  /* ------------------------------------------------------------------- */

  async function getMyLeaderboardEntry() {
    if (!signedIn) return null;
    const { data, error } = await client()
      .from('leaderboard')
      .select('display_name, streak')
      .eq('user_id', currentUser.id)
      .maybeSingle();
    if (error) {
      console.warn('Leaderboard read failed:', error.message);
      return null;
    }
    return data;
  }

  async function joinLeaderboard(displayName, streak) {
    if (!signedIn) return;
    const { error } = await client().from('leaderboard').upsert({
      user_id: currentUser.id,
      display_name: displayName.slice(0, 24),
      streak: streak || 0,
      updated_at: new Date().toISOString(),
    });
    if (error) throw error;
  }

  async function leaveLeaderboard() {
    if (!signedIn) return;
    const { error } = await client().from('leaderboard').delete().eq('user_id', currentUser.id);
    if (error) throw error;
  }

  /* Called whenever the local streak changes — a silent no-op if the
     user never opted in, since an update to a missing row updates 0 rows. */
  async function updateMyStreak(streak) {
    if (!signedIn) return;
    const { error } = await client()
      .from('leaderboard')
      .update({ streak, updated_at: new Date().toISOString() })
      .eq('user_id', currentUser.id);
    if (error) console.warn('Leaderboard streak update failed:', error.message);
  }

  async function fetchLeaderboard(limit) {
    const { data, error } = await client()
      .from('leaderboard')
      .select('user_id, display_name, streak')
      .order('streak', { ascending: false })
      .limit(limit || 50);
    if (error) {
      console.warn('Leaderboard fetch failed:', error.message);
      return [];
    }
    return data || [];
  }

  /* ------------------------------------------------------------------- */
  /* Auth screen                                                          */
  /* ------------------------------------------------------------------- */

  function showAuthScreen(cb) {
    onAuthed = cb;
    document.getElementById('auth').hidden = false;
    wireAuth();
    renderMode();
  }

  function wireAuth() {
    if (wired) return;
    wired = true;
    document.getElementById('auth-form').addEventListener('submit', submit);
    document.getElementById('auth-toggle').addEventListener('click', () => {
      mode = mode === 'signin' ? 'signup' : 'signin';
      renderMode();
    });
  }

  function renderMode() {
    const signin = mode === 'signin';
    document.getElementById('auth-submit').textContent = signin ? 'Sign in' : 'Create account';
    document.getElementById('auth-toggle-label').textContent = signin
      ? 'New to MedBuddy?'
      : 'Already have an account?';
    document.getElementById('auth-toggle').textContent = signin ? 'Create an account' : 'Sign in';
    document.getElementById('auth-password').autocomplete = signin
      ? 'current-password'
      : 'new-password';
    hideMessages();
  }

  function hideMessages() {
    document.getElementById('auth-error').hidden = true;
    document.getElementById('auth-notice').hidden = true;
  }

  function showError(msg) {
    const el = document.getElementById('auth-error');
    el.textContent = msg;
    el.hidden = false;
  }

  function showNotice(msg) {
    const el = document.getElementById('auth-notice');
    el.textContent = msg;
    el.hidden = false;
  }

  async function submit(e) {
    e.preventDefault();
    hideMessages();

    const btn = document.getElementById('auth-submit');
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'Working…';

    try {
      if (mode === 'signup') {
        const { data, error } = await client().auth.signUp({ email, password });
        if (error) throw error;
        if (!data.session) {
          /* Email confirmation is turned on in the project settings —
             the user has to click the link before they can sign in. */
          mode = 'signin';
          renderMode();
          showNotice('Almost there — check your email for a confirmation link, then sign in.');
          return;
        }
      } else {
        const { error } = await client().auth.signInWithPassword({ email, password });
        if (error) throw error;
      }

      await getSession();
      document.getElementById('auth').hidden = true;
      if (onAuthed) onAuthed();
    } catch (err) {
      showError(err.message || 'Something went wrong. Try again.');
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  /* Signing out on a shared device must leave nothing behind:
     clear the cloud session, the local cache, and the document store. */
  async function signOut() {
    try {
      await client().auth.signOut();
    } catch (err) {
      void err;
    }
    try {
      localStorage.removeItem('dosenote.v1');
      localStorage.removeItem('dosenote.owner');
    } catch (err) {
      void err;
    }
    try {
      indexedDB.deleteDatabase('medbuddy-insurance');
    } catch (err) {
      void err;
    }
    location.reload();
  }

  window.Cloud = {
    available,
    getSession,
    isSignedIn,
    userId,
    userEmail,
    fetchState,
    pushState,
    pushStateDebounced,
    showAuthScreen,
    signOut,
    getMyLeaderboardEntry,
    joinLeaderboard,
    leaveLeaderboard,
    updateMyStreak,
    fetchLeaderboard,
  };
})();
