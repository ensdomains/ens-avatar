# patch for: https://github.com/jaredpalmer/tsdx/issues/667
# patch for: https://github.com/jaredpalmer/tsdx/issues/276#issuecomment-1143821119

modify_imports() {
  sed -i '' 's/\.\.\/\.\.\/_virtual/\.\.\/_virtual/g' "$1"
  sed -i '' 's/\.\.\/\.\.\/node_modules/\.\.\/node_modules/g' "$1"
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
sed -i '' 's/\.\.\/_virtual/\.\/_virtual/g' "dist/index.esm.js"
sed -i '' 's/\.\.\/node_modules/\.\/node_modules/g' "dist/index.esm.js"