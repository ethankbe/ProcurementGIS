import pandas as pd

df = pd.read_csv("ncr_it_awarded2.csv", dtype=str)

BID = "Bid Reference No."
AWARD = "Award Reference No."
PE = "Procuring Entity (PE)"
CITY = "City/Municipality"
TITLE = "Notice Title"

# clean the reference numbers (removes the ".0" spreadsheet artifact)
for c in (BID, AWARD):
    df[c] = df[c].str.replace(r"\.0$", "", regex=True).str.strip()

# pull the office out of the title: text after the last " - "
df["unit"] = df[TITLE].str.extract(r"\s-\s([^-]+)$", expand=False).str.strip().str.upper()

df["office_key"] = (df[PE].fillna("").str.upper().str.strip() + " | " +
                    df["unit"].fillna("") + " | " +
                    df[CITY].fillna("").str.upper().str.strip())

# prefer rows that have an award reference, since the Award Notices page
# only lists awarded contracts
df["has_award"] = df[AWARD].notna() & (df[AWARD] != "")
df = df.sort_values("has_award", ascending=False)

targets = (df.drop_duplicates("office_key")
             [["office_key", BID, AWARD]]
             .rename(columns={BID: "bid_ref", AWARD: "award_ref"}))
targets.to_csv("targets.csv", index=False)

print(len(df), "contract rows ->", len(targets), "unique offices")
print(targets["award_ref"].notna().sum(), "of those have an award reference")