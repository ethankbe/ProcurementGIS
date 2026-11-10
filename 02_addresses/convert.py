import pandas as pd

df = pd.read_json("addresses_raw.jsonl", lines=True, dtype=str)
print(df["status"].value_counts())
df.to_csv("addresses_raw.csv", index=False)