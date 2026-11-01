export default async function Home() {
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/health`);
  return <main>{res.status}</main>;
}
