import unittest
from unittest.mock import patch

import app as app_module


class AuthenticationSecurityTests(unittest.TestCase):
    def setUp(self):
        app_module.app.config.update(
            TESTING=True,
            SECRET_KEY="test-secret",
        )
        self.client = app_module.app.test_client()

    def test_dashboard_redirects_without_server_session(self):
        response = self.client.get("/dashboard")

        self.assertEqual(response.status_code, 302)
        self.assertIn("/login?next=/dashboard", response.location)

    def test_profile_redirects_without_server_session(self):
        response = self.client.get("/profile")

        self.assertEqual(response.status_code, 302)
        self.assertIn("/login?next=/profile", response.location)

    def test_session_login_rejects_missing_token(self):
        response = self.client.post(
            "/session-login",
            json={},
        )

        self.assertEqual(response.status_code, 400)

    @patch("app._get_firestore_db", return_value=object())
    @patch("app.firebase_admin_auth")
    def test_verified_firebase_token_creates_session(
        self,
        firebase_auth,
        _firestore_db,
    ):
        firebase_auth.verify_id_token.return_value = {
            "uid": "user-123",
            "email": "user@example.com",
            "name": "Test User",
            "email_verified": True,
        }

        response = self.client.post(
            "/session-login",
            json={"idToken": "valid-token"},
        )

        self.assertEqual(response.status_code, 200)

        with self.client.session_transaction() as session:
            self.assertEqual(
                session["user"]["uid"],
                "user-123",
            )

    @patch("app._get_firestore_db", return_value=object())
    @patch("app.firebase_admin_auth")
    def test_unverified_email_does_not_create_session(
        self,
        firebase_auth,
        _firestore_db,
    ):
        firebase_auth.verify_id_token.return_value = {
            "uid": "user-123",
            "email": "user@example.com",
            "email_verified": False,
        }

        response = self.client.post(
            "/session-login",
            json={"idToken": "unverified-token"},
        )

        self.assertEqual(response.status_code, 403)

        with self.client.session_transaction() as session:
            self.assertNotIn("user", session)

    @patch("app._get_firestore_db", return_value=object())
    @patch("app.firebase_admin_auth")
    def test_invalid_token_is_rejected(
        self,
        firebase_auth,
        _firestore_db,
    ):
        firebase_auth.verify_id_token.side_effect = ValueError(
            "invalid token"
        )

        response = self.client.post(
            "/session-login",
            json={"idToken": "invalid-token"},
        )

        self.assertEqual(response.status_code, 401)


if __name__ == "__main__":
    unittest.main()
