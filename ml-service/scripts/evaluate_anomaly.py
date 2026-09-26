"""Does ANY feature block predict the yield ANOMALY? Answer: no.

    python -m scripts.evaluate_anomaly

The counterpart to scripts.diagnose_signal. That script shows why the pooled
R2 in train_real is meaningless; this one removes the thing inflating it and
reports what is left.

The target is y / mean(district, crop), so every crop sits on one scale and
the district-crop norm is divided out. What remains is the only question the
product actually asks: is THIS season better or worse than normal here?

The baseline is rebuilt inside every fold. Computing it once over all
training rows leaks across CV folds -- each fold's held-out rows would be
normalised partly by their own values.

The competitor is "always normal", i.e. predict 1.0. A model that cannot beat
that has learned nothing about the season.

PLACEBO is six random constants per district: identical district-identifying
power to the soil block, zero agronomic content. It scores at the TOP of the
GroupKFold column, which is the finding -- every real feature block is
indistinguishable from noise once district recall is removed.
"""
import numpy as np
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import r2_score, mean_absolute_error, mean_squared_error
from sklearn.model_selection import GroupKFold
from scripts.train_real import load, baselines, to_anomaly, TEST_SEASONS, RF_KWARGS

variants = [("indices + crop", False, False),
            ("+ soil",          True,  False),
            ("+ weather",       False, True),
            ("+ soil + weather",True,  True)]

print(f"{'features':20s} {'cols':>5s} {'GroupKFold':>11s} {'holdout':>9s} "
      f"{'vs 1.0':>8s} {'gain':>7s} {'RMSE':>7s} {'MAE':>7s}")
print("-" * 80)

store = {}
for label, soil, wx in variants:
    X, y, districts, seasons, crops = load(use_soil=soil, use_weather=wx)
    is_test = np.isin(seasons, list(TEST_SEASONS))
    tr = np.where(~is_test)[0]; te = np.where(is_test)[0]

    def fold(a, b):
        mask = np.ones(len(y), bool); mask[a] = False
        base, fb = baselines(y, districts, crops, mask)
        ya, _ = to_anomaly(y, districts, crops, base, fb)
        rf = RandomForestRegressor(**RF_KWARGS).fit(X[a], ya[a])
        return rf.predict(X[b]), ya[b]

    gk = GroupKFold(5)
    g = [r2_score(t, p) for p, t in
         (fold(tr[i], tr[j]) for i, j in gk.split(tr, groups=districts[tr]))]
    p, t = fold(tr, te)
    ones = np.ones_like(t)
    hb = r2_score(t, ones)
    store[label] = (t, p)
    print(f"{label:20s} {X.shape[1]:>5d} {np.mean(g):>+11.3f} {r2_score(t,p):>+9.3f} "
          f"{hb:>+8.3f} {r2_score(t,p)-hb:>+7.3f} "
          f"{mean_squared_error(t,p)**0.5:>7.3f} {mean_absolute_error(t,p):>7.3f}")

# PLACEBO: six random constants per district. Same district-identifying power
# as soil, zero agronomic content. Anything soil gains that this also gains is
# not soil knowledge, it is district recall.
X, y, districts, seasons, crops = load()
rng = np.random.default_rng(0)
fake = {d: rng.normal(size=6) for d in set(districts)}
Xp = np.hstack([X, np.array([fake[d] for d in districts])])
is_test = np.isin(seasons, list(TEST_SEASONS))
tr, te = np.where(~is_test)[0], np.where(is_test)[0]
def fold(a, b):
    mask = np.ones(len(y), bool); mask[a] = False
    base, fb = baselines(y, districts, crops, mask)
    ya, _ = to_anomaly(y, districts, crops, base, fb)
    return RandomForestRegressor(**RF_KWARGS).fit(Xp[a], ya[a]).predict(Xp[b]), ya[b]
gk = GroupKFold(5)
g = [r2_score(t, p) for p, t in (fold(tr[i], tr[j]) for i, j in gk.split(tr, groups=districts[tr]))]
p, t = fold(tr, te); hb = r2_score(t, np.ones_like(t))
print(f"{'PLACEBO district id':20s} {Xp.shape[1]:>5d} {np.mean(g):>+11.3f} {r2_score(t,p):>+9.3f} "
      f"{hb:>+8.3f} {r2_score(t,p)-hb:>+7.3f}")

print("\nper-crop holdout gain over 'always normal', best variant (+ soil + weather)")
t, p = store["+ soil + weather"]
X, y, districts, seasons, crops = load(use_soil=True, use_weather=True)
cte = crops[np.isin(seasons, list(TEST_SEASONS))]
print(f"{'crop':10s} {'n':>4s} {'model':>8s} {'vs 1.0':>8s} {'gain':>7s}")
print("-"*42)
for c in sorted(set(cte)):
    m = cte == c
    if m.sum() < 5: continue
    rm = r2_score(t[m], p[m]); rb = r2_score(t[m], np.ones(m.sum()))
    print(f"{c:10s} {m.sum():>4d} {rm:>+8.3f} {rb:>+8.3f} {rm-rb:>+7.3f}")
