// netlify/functions/auth-logout.js
// Clears the session cookie and redirects to Auth0's logout endpoint,
// which then redirects back to the site homepage.
//
// Required env vars: AUTH0_DOMAIN, AUTH0_CLIENT_ID, URL

const { AUTH0_DOMAIN, AUTH0_CLIENT_ID, URL: SITE_URL } = process.env;
const COOKIE_NAME = 'apex_session';

exports.handler = async () => {
  const returnTo = encodeURIComponent(SITE_URL || '/');
  const auth0Logout =
    `https://${AUTH0_DOMAIN}/v2/logout` +
    `?client_id=${AUTH0_CLIENT_ID}` +
    `&returnTo=${returnTo}`;

  return {
    statusCode: 302,
    headers: {
      Location: auth0Logout,
      // Expire the cookie immediately
      'Set-Cookie': [
        `${COOKIE_NAME}=`,
        'Max-Age=0',
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        'Secure',
      ].join('; '),
    },
    body: '',
  };
};
