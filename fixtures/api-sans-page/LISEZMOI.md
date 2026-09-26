Le témoin NÉGATIF d'AC-6, et la raison pour laquelle le déclencheur est le `content-type`
observé et non la présence d'`app.url` : une API déclare `app.url` exactement comme un site.

Cette app sert du JSON. Elle ne doit recevoir **aucun** rappel sur `a11y`, `mobile`,
`budgets` ou `seo` — un audit d'accessibilité sur une réponse JSON n'a pas de sens, et un
rappel qui tombe partout finit par n'être lu nulle part.
