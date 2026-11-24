import pandas as pd

df = pd.read_json("addresses_raw.jsonl", lines=True, dtype=str)
# re-runs append retried offices; keep only the latest row per office
df = df.drop_duplicates("office_key", keep="last")
print(df["status"].value_counts())
df.to_csv("addresses_raw.csv", index=False)