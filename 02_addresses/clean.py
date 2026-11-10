import pandas as pd, re

df = pd.read_csv("addresses_raw.csv", dtype=str)
good = df[df["status"] == "ok"].copy()

def clean(addr):
    a = re.sub(r"\bBrgy\.?", "Barangay", addr, flags=re.I)
    parts = [x.strip() for x in a.split(",") if x.strip()]
    dedup = [x for i, x in enumerate(parts) if i == 0 or x.lower() != parts[i-1].lower()]
    return ", ".join(dedup) + ", Philippines"

good["clean_address"] = good["raw_address"].apply(clean)
good.to_csv("addresses_clean.csv", index=False)
print(len(good), "rows ready;", len(df) - len(good), "need attention")