# import os
# import firebase_admin
# from firebase_admin import credentials
# from firebase_admin import firestore

# SERVICE_ACCOUNT_PATH = os.getenv("FIREBASE_SERVICE_ACCOUNT")

# if not firebase_admin._apps:
#     if not SERVICE_ACCOUNT_PATH:
#         raise RuntimeError(
#             "FIREBASE_SERVICE_ACCOUNT environment variable is not set."
#         )

#     cred = credentials.Certificate(SERVICE_ACCOUNT_PATH)
#     firebase_admin.initialize_app(cred)

# db = firestore.client()