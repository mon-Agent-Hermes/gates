# projet à la config invalide (fixture)

Ce projet déclare `expect: { json: … }` sur une probe `http` — une clé qu'aucun check
ne lit. Avant le correctif, gates la traversait en silence : la probe ne contrôlait que
le code HTTP, et AC-7 virait au VERT sans que le corps de la réponse, c'est-à-dire
l'objet du projet, ait jamais été regardé.

`gates check` doit y sortir en **2** (config invalide) en nommant la clé — pas en 1 :
c'est le `gates.json` qu'il faut corriger, pas le code.
