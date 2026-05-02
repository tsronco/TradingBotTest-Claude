import { useParams } from 'react-router-dom';
export default function Lookup() {
  const { symbol } = useParams();
  return <div className="p-6">Lookup: {symbol} (TBD)</div>;
}
