Deux racines posées par **convention** du framework, qui ne s'importent pas l'une l'autre —
la disposition d'un App Router : `layout.tsx` habille la page, `page.tsx` porte le contenu,
et rien dans le code ne relie les deux.

Avec une entrée unique, `layout.tsx` (et tout ce qu'il tire, ici `globals.css`) était déclaré
**injoignable** : un rouge sur un fichier obligatoire du framework, que personne ne peut
corriger sans casser le projet. Le pire des faux positifs — il frappe le code juste.

Sert à vérifier qu'`entry` accepte une liste (AC-7).
