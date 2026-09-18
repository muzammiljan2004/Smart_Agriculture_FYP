import os
from functools import lru_cache

from dotenv import load_dotenv
from supabase import create_client, Client

load_dotenv()


@lru_cache(maxsize=1)
def db() -> Client:
    """Supabase client with the service_role key.

    service_role BYPASSES RLS -- that is the point: this service writes
    satellite_features and predictions, which no farmer is allowed to write
    (see the migration). It also means this key must never reach /frontend.

    Lazy so that /predict works without Supabase configured at all.
    """
    return create_client(
        os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    )
