export async function handleSettled(promises: Promise<any>[]) {
  const values = [];
  const results = await Promise.allSettled(promises);
  for (let result of results) {
    if (result.status === 'fulfilled') values.push(result.value);
    else if (result.status === 'rejected') values.push(null);
  }
  return values;
}
