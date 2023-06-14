#!/bin/bash

# patch for: https://github.com/jaredpalmer/tsdx/issues/667
# patch for: https://github.com/jaredpalmer/tsdx/issues/276#issuecomment-1143821119

OS=$(uname)

if [[ "$OS" == "Darwin" ]]; then # macOS
  SEDCMD="sed -i ''"
elif [[ "$OS" == "Linux" ]]; then
  SEDCMD="sed -i"
else
  echo "Unsupported OS"
  exit 1
fi

modify_imports() {
  $SEDCMD -i '' 's/\.\.\/\.\.\/_virtual/\.\.\/_virtual/g' "$1"
  $SEDCMD -i '' 's/\.\.\/\.\.\/node_modules/\.\.\/node_modules/g' "$1"
}

files=("dist/specs/*.esm.js" "dist/utils/*.esm.js")

for path in "${files[@]}"
do
  for file in $path
  do
    modify_imports "$file"
  done
done

# dist/index.esm.js replaced seperately
$SEDCMD -i '' 's/\.\.\/_virtual/\.\/_virtual/g' "dist/index.esm.js"
$SEDCMD -i '' 's/\.\.\/node_modules/\.\/node_modules/g' "dist/index.esm.js"